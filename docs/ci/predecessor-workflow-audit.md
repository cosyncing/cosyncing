# Predecessor workflow audit

The sealed predecessor revisions contained six client workflows and five broker
workflows. They were reviewed before any workflow was admitted to this lineage.

| Dependency class | Finding | Public disposition |
|---|---|---|
| Persistent runners | Client Android/Linux and Apple smokes plus broker ARM validation used privately managed hosts | Not imported; hosted Ubuntu, macOS, Windows, and ARM jobs replace required coverage |
| Personal filesystem state | Emulator homes, lock cleanup, preinstalled SDKs, and local tool state were assumed | Removed; workflows install pinned toolchains and use runner-temporary paths |
| Sibling repository | Client contract sync used an environment-selected sibling broker root and skipped when that checkout was absent | Replaced by same-checkout `scripts/contracts/check.sh`; missing generation fails |
| Private network | Real-agent/private-network traces existed outside deterministic gates | Optional maintainer validation only; never required for merge or release |
| Secrets | Broker signing uses a private key, public key, and key identifier | Restricted to protected candidate/promotion environments; absent from PR jobs |
| Actions artifacts | Client smokes uploaded screenshots/build outputs; broker release correctly used GitHub Releases | Test uploads removed from required CI; Releases remain the only permanent distribution surface |
| Untrusted code | Some self-managed jobs could be manually/label-triggered from pull requests | Not imported; fork code runs only on ephemeral GitHub-hosted runners |
| Mutable Actions | Predecessor actions used version tags | Every admitted third-party Action is pinned to a full commit SHA |
| Duplicate gates | Client and broker repeated setup and overlapping analysis/build checks | Consolidated into `ci.yml`; release gate is limited to native package/hash coverage |

Neither predecessor used `pull_request_target` to execute contributor code. The
complete hash-addressed audit, including retired labels and paths, remains in
the private migration record and is not distributed.
