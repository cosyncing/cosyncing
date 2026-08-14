# Consolidation transition

## A. Private consolidation — complete

The predecessor client and broker repositories were treated as read-only. A
curated export created the consolidated monorepo, repaired root-relative tools,
and kept private plans and physical-host evidence outside the public lineage.

## B. Public-readiness gate — complete for source publication

Hosted broker, contract, Flutter, web, platform, public-tree, workflow, history,
and secret checks passed. The tracked workflow mode is `public-hosted`, required
branch rules are active, and a real fork pull request passed without secrets.

## C. Source visibility transition — complete

The source repository and project website are public. The private
`docs-internal/` repository remains a nested ignored checkout on maintainer
machines. Maintainer implementation history remains separate from the public
fresh-history lineage and is never pushed directly into it.

Compiled native broker distribution is a separate transition and is not
complete. Before any compiled broker prerelease, resolve the binary-license
gate, provision protected signing environments, and run the published-candidate
upgrade/unhealthy-rollback acceptance described in the release documentation.
The non-embedded npm JavaScript package does not distribute the Bun runtime or
a compiled broker and is governed by its own readiness record.

## D. Post-public validation — complete for source, npm, and client releases

The contributor fork path and maintainer hosted checks are proven. The npm
JavaScript package and advertised Android, Linux, macOS, and Windows clients use
protected release workflows and physically accepted candidates. iOS remains a
CI-built source target rather than a distributed client. Remaining transition
work applies only to a future compiled native broker: legal approval, protected
signing, prerelease/stable promotion, and packaged acceptance. Release
validation must complete without relying on a maintainer workstation as CI
infrastructure.

## Traceability

| Delivery wave | Transition stage | Outcome |
|---|---|---|
| Decisions and source freeze | A | approved scope, sealed inputs, recoverable private backups |
| Public-safe lineage | A | curated export and fresh reviewed Git history |
| Monorepo and hosted parity | A → B | consolidated workspaces and public-safe hosted gates |
| Contract and compatibility | B | same-checkout export and client adoption |
| Modular boundaries | B | dependency rules with broker domains, provider adapters, and Flutter capability ownership |
| Evidence, docs, and local rehearsal | B | accurate public material and local candidate proof |
| Source publication | C | public repository, website, branch rules, and fork PR proof |
| npm JavaScript release | C → D | protected trusted publishing, staged approval, and package-manager-owned updates |
| Flutter client release | C → D | protected candidate staging, physical acceptance, and exact-asset stable promotion |
| Compiled release acceptance | C → D | legal approval, protected signing, candidate upgrade/rollback, stable promotion |
