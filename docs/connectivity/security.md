# Connectivity security

> [!WARNING]
> Public or untrusted-network exposure requires broker contract revision 17 or
> later. Revision 16 and earlier do not enforce the principal, revocation, and
> artifact boundaries described here and must not be exposed publicly. Publish
> or update a revision-17-capable client before promoting the revision-17
> broker. Run `cosy version --json` on the broker host and confirm that
> `contract.revision` is at least `17` before creating any public route.

The proxy or tunnel carries traffic; cosyncing authentication remains the
application security boundary. TLS, a private overlay, or proxy authentication
does not replace broker-token or paired-device authentication.

Every HTTP and WebSocket client is treated as remote, including a browser on
the broker host. A loopback TCP source can be a proxy and is never evidence of
same-machine trust. Authenticated workspace browsing and transcript export are
therefore disabled by default for all HTTP clients. To enable either feature,
add the corresponding local-only flags to `~/.cosyncing/config.json`, preserving
the existing fields, then run `cosy restart`:

```json
{
  "features": {
    "httpWorkspaceBrowsing": true,
    "httpTranscriptExport": true
  }
}
```

These flags grant the feature to authenticated HTTP clients; they do not make
proxy source addresses trusted. Enable only the features the deployment needs.

Before exposing the broker:

- Expose only the proxy or tunnel. Keep cosyncing on `127.0.0.1:7734`; never
  publish the broker port or bind it to `0.0.0.0`.
- Require HTTPS/WSS for public exposure. Use an authenticated, encrypted overlay
  or HTTPS for private remote access.
- Keep all sensitive HTTP routes and WebSockets behind cosyncing authentication.
- Pair devices so each receives a revocable, non-owner credential. Paired
  devices can observe, drive, and transfer files by default, but cannot create
  pairing offers, administer devices, change global runtime policy, restart the
  broker, or start updates.
- Put credentials in protocol headers or frames, never URLs. Configure proxy
  access logs to omit authorization headers and sensitive request bodies.
- Do not treat `Host`, `Forwarded`, or `X-Forwarded-*` headers as authorization or
  broker identity evidence.
- Preserve broker upload and request-size limits. Add a proxy limit that is no
  smaller than the broker limit you intend to support.
- Keep pairing bootstrap narrowly scoped and rate-limited. Revoke lost devices
  immediately and verify their HTTP, unused-ticket, and live-WebSocket access is
  gone. Rotate any owner credential that may have leaked.
- Patch the proxy, tunnel, VPN, and host OS. Their lifecycle is independent of
  `cosy setup`, `repair`, and `uninstall`.

## Source-development brokers

The unconfigured source runtime retains a tokenless loopback mode for local
development and isolated test fixtures. It prints a security warning at startup.
That mode has no application authentication boundary: do not put it behind a
proxy, tunnel, VPN, mesh route, or port forward.

Any remotely reachable deployment must use setup-managed credentials or an
explicit development credential. The loopback bind alone does not make a
forwarded request local or authenticated.

Before exposing any source broker, request `/api/sessions` through the final
origin without credentials and require a `401 Unauthorized` response.

Removal means stopping and deleting the operator-owned ingress, removing its DNS
and firewall exposure, and rotating credentials if the endpoint was exposed to
an untrusted network. `cosy uninstall` intentionally does none of those tasks.
