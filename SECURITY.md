# Security Policy

## Supported versions

Security fixes target the latest stable client and broker releases. A fix may
also be backported when maintainers can do so without weakening protocol or
release verification.

## Reporting a vulnerability

Use GitHub private vulnerability reporting for this repository. Do not open a
public issue for a suspected vulnerability and do not include live credentials
or personal data in test cases. Include affected versions, impact, reproduction
steps, and any proposed mitigation.

Maintainers will acknowledge a complete report within seven days and coordinate
disclosure after a fix or mitigation is available. This is a target, not a
service-level agreement.

Compiled broker binaries must be verified through the documented signing flow.
The non-embedded npm JavaScript distribution uses protected trusted publishing
and the package-manager-owned update path documented in
[npm distribution readiness](docs/legal/npm-javascript-distribution-readiness.md).

## Network boundary

The broker listens only on `127.0.0.1`. cosyncing does not configure proxies,
tunnels, VPNs, DNS, certificates, or firewall rules. Operators who expose the
loopback broker must preserve application authentication, require HTTPS/WSS for
public traffic, and follow the [connectivity security checklist](docs/connectivity/security.md).
Forwarded headers are not authorization evidence, and uninstall leaves external
connectivity untouched.
