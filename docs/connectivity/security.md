# Connectivity security

The proxy or tunnel carries traffic; cosyncing authentication remains the
application security boundary. TLS, a private overlay, or proxy authentication
does not replace broker-token or paired-device authentication.

Before exposing the broker:

- Expose only the proxy or tunnel. Keep cosyncing on `127.0.0.1:7734`; never
  publish the broker port or bind it to `0.0.0.0`.
- Require HTTPS/WSS for public exposure. Use an authenticated, encrypted overlay
  or HTTPS for private remote access.
- Keep all sensitive HTTP routes and WebSockets behind cosyncing authentication.
- Pair devices so each receives a revocable credential. Do not share the master
  broker token when a peer credential is sufficient.
- Put credentials in protocol headers or frames, never URLs. Configure proxy
  access logs to omit authorization headers and sensitive request bodies.
- Do not treat `Host`, `Forwarded`, or `X-Forwarded-*` headers as authorization or
  broker identity evidence.
- Preserve broker upload and request-size limits. Add a proxy limit that is no
  smaller than the broker limit you intend to support.
- Keep pairing bootstrap narrowly scoped and rate-limited. Revoke lost devices
  and rotate any credential that may have leaked.
- Patch the proxy, tunnel, VPN, and host OS. Their lifecycle is independent of
  `cosy setup`, `repair`, and `uninstall`.

Removal means stopping and deleting the operator-owned ingress, removing its DNS
and firewall exposure, and rotating credentials if the endpoint was exposed to
an untrusted network. `cosy uninstall` intentionally does none of those tasks.
