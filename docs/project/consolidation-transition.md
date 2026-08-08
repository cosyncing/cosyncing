# Consolidation transition

## A. Private consolidation

The source client and broker repositories were treated as read-only. A curated,
commit-addressed export created a fresh private working lineage. Hosted public
workflows were added and preserved as an exact inactive profile while the
repository remained private. Active private workflows use generic self-hosted
platform labels to avoid private-repository hosted-runner charges. The saved
profile is restored by one audited script before visibility changes. Private
migration evidence and local agent state stayed outside the public tree.

## B. Public-readiness gate

Hosted broker, contract, Flutter, web, and platform checks must pass without a
personal runner. Contract generation must use one checkout. History and secret
scans must report no unresolved findings. Required checks, environments,
rulesets, and tag protection must be configured. The tracked workflow mode must
be `public-hosted`, and the active workflow files must match the saved public
profile byte for byte.

## C. Visibility transition

Changing visibility requires an explicit dated owner decision. Before that
change, enable fork workflow approval settings, remove any required private
check, apply branch/tag rulesets, and verify the configured release
environments. Then run a real fork pull request with no secrets.

Before any compiled broker prerelease, run the protected hosted
app-triggered signed-candidate upgrade and unhealthy-rollback exercise. The
owner moved this exercise from Phase 11 to the mandatory Phase 12 pre-release
gate on 2026-07-19; it cannot depend on personal hardware or be bypassed by a
visibility-only transition.

## D. Post-public validation

Test a contributor pull request, maintainer merge, broker prerelease, and stable
promotion. Confirm that every required check and release path completes while
all maintainer workstations are offline.

## Traceability

| Delivery wave | Runbook phases | Transition stage | Outcome |
|---|---:|---|---|
| Decisions and source freeze | 0–2 | A | approved scope, sealed inputs, recoverable private backups |
| Public-safe lineage | 3–5 | A | curated export and fresh reviewed Git history |
| Mechanical monorepo and hosted parity | 6 | A → B | `apps/client`, `apps/poc-ui`, root workspaces, and public-safe hosted gates |
| Contract and compatibility | 7–8 | B | same-checkout export and BPC13 client adoption |
| Modular boundaries | 9 | B | dependency rules and named hotspot ratchets |
| Evidence, docs, and local rehearsal | 10–11 | B | accurate public material and exact local candidate proof |
| Publication and hosted pre-release acceptance | 12 | C | approved refs/settings plus the mandatory real candidate upgrade/rollback gate |
| Stabilization | 13 | D | contributor/release paths proven; predecessors retired privately |
