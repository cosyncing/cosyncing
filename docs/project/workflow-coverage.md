# Workflow coverage map

The active `.github/workflows` tree uses the public GitHub-hosted profile.
`.github/workflow-mode` records `public-hosted`, and the workflow audit rejects
self-hosted runner selection. The tracked workflows are the canonical profile;
the retired private profile is preserved only in the private internal-docs
archive. The table below describes the active coverage.

| Predecessor gate | Consolidated destination | Required | Current proof |
|---|---|---:|---|
| Client hosted analysis/test | `ci.yml` / `client` suite, three shards | yes | Format, analysis and feature tests through the shared runner |
| Reusable Dart package suites | `ci.yml` / `client` suite | yes | Package analysis and test tasks in the suite manifest |
| Client web gate | `ci.yml` / `web` suite | yes | Built web client exercised against fixture brokers |
| Client Linux/Android personal lanes | `ci.yml` / Linux and Android matrix | yes | Hosted platform builds pass |
| Client macOS/iOS personal lane | `ci.yml` / Apple matrix | yes | Hosted platform builds pass |
| Client Android/macOS/iOS runtime smoke | `platform-runtime.yml` / hosted emulator and simulator lanes | no | Each hosted lane passes before runtime support is advertised; never depends on a personal runner |
| Client Windows gate | `ci.yml` / Windows build | yes | Hosted Windows build passes |
| Client sibling contract sync | `ci.yml` / `policy` suite | yes | Same-checkout generated contract check |
| Broker deterministic CI | `ci.yml` / `broker`, `adapters`, `packaging` suites | yes | Functional scenarios, retained narrow cases and packaging checks |
| Broker Windows behavior | `ci.yml` / `windows` suite | when relevant | Native Windows host, service, installer and broker scenarios |
| Reliability and extended stress | `nightly.yml` | no | Broker/adapters/packaging repeated three times without retry; client stress |
| Broker native package lanes | `broker-release-gate.yml` | yes | Ephemeral hosted x64/arm64 builds; no native broker publication |
| Broker JavaScript/web parity | `broker-release-gate.yml` | yes | Actual bundled candidate executes through explicit Bun against its web sidecar |
| Broker candidate staging | `broker-release.yml` | tag only | Protected JavaScript/web and matching-client flow; requires a new candidate acceptance pass |
| Broker stable promotion | `broker-release-promote.yml` | manual | Protected signed exact-asset verification; rejects native brokers and bundled runtimes |
| Flutter client candidate | `client-release.yml` | tag only | Exact tagged source passes the full gate and stages Android, Linux, macOS, and Windows assets |
| Flutter client stable promotion | `client-release-promote.yml` | manual | Protected promotion verifies the physically accepted prerelease asset set without rebuilding |
| Private-network/hardware evidence | maintainer physical acceptance | no PR aggregate | Required when the release or feature acceptance plan calls for it |

No predecessor coverage was retired merely because a runner disappeared.
Each hosted replacement passed before the private workflow profile was removed
from the public lineage.

Repository rulesets require only `CI required` and `Broker Release Gate
required`. Their always-running dependency checks cover the matrix rows above
for source changes, allowing the Windows broker skip only when the classifier
permits it. For a fail-closed documentation-only classification, both
workflows enforce public-tree policy, intentionally skip expensive child jobs,
and require the aggregate job to prove that every expected child was skipped.

Use [Tests and CI](../development/testing.md) for future coverage changes and
runtime/reliability expectations. A task that passes only on retry is reported
as flaky and remains a required follow-up.
