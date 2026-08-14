# Workflow coverage map

The active `.github/workflows` tree uses the public GitHub-hosted profile.
`.github/workflow-mode` records `public-hosted`, and the workflow audit rejects
self-hosted runner selection. The tracked workflows are the canonical profile;
the retired private profile is preserved only in the private internal-docs
archive. The table below describes the active coverage.

| Predecessor gate | Consolidated destination | Required | Current proof |
|---|---|---:|---|
| Client hosted analysis/test | `ci.yml` / Flutter analysis and tests | yes | Hosted lane passes on public pull requests and `main` |
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
| npm JavaScript package | `npm-publish.yml` | release only | Exact candidate passes offline package verification, trusted staging, protected review, and interactive approval |
| Flutter client candidate | `client-release.yml` | tag only | Exact tagged source passes the full gate and stages Android, Linux, macOS, and Windows assets |
| Flutter client stable promotion | `client-release-promote.yml` | manual | Protected promotion verifies the physically accepted prerelease asset set without rebuilding |
| Private-network/hardware evidence | optional maintainer validation | no | Never a merge or release dependency |

No predecessor coverage was retired merely because a runner disappeared.
Each hosted replacement passed before the private workflow profile was removed
from the public lineage.

Repository rulesets require only `CI required` and `Broker Release Gate
required`. Their always-running dependency checks cover the matrix rows above
for source changes. For a fail-closed documentation-only classification, both
workflows enforce public-tree policy, intentionally skip expensive child jobs,
and require the aggregate job to prove that every expected child was skipped.
