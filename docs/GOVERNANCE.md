# Governance

cosyncing is maintainer-led. Maintainers set release scope, merge changes,
manage security response, and protect protocol compatibility. Technical
decisions should be made in public issues or pull requests with the relevant
CODEOWNERS requested for review.

## Changes

- Small fixes use normal pull-request review and required CI.
- Protocol, security, persistence, compatibility, or release changes require a
  written rationale, tests, and updated public documentation.
- Breaking changes require a migration or explicit compatibility policy and a
  maintainer decision before implementation.
- A maintainer with a conflict of interest should disclose it and seek another
  reviewer when one is available.

## Releases and security

Only maintainers may create protected release tags, approve signing
environments, or promote stable releases. Security reports follow
[SECURITY.md](../SECURITY.md); embargoed details stay private until coordinated
disclosure is safe.

Governance changes use the same pull-request and review process as source
changes. Maintainer succession or removal must be recorded publicly before
repository or signing access changes.
