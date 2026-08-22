# Connectivity troubleshooting

Start at the boundary and move outward. Do not change the broker listener.

## Local broker unavailable

Run `cosy status` and `cosy doctor`, then test
`http://127.0.0.1:7734/api/health` on the broker host. Fix cosyncing or its owned
service before debugging the connectivity layer.

## Proxy returns 502

Confirm the proxy runs on the broker host, targets `127.0.0.1:7734`, and can
reach local health. In containers, `127.0.0.1` is the container itself; use an
explicit, secured host path or run the proxy on the host.

## WebSocket connects then closes

Check upgrade headers, idle/read timeouts, reload behavior, and tunnel
keepalives. nginx requires explicit WebSocket header forwarding.

## Uploads fail

Raise the proxy or tunnel request-body limit only to the intended broker limit.
Check timeouts and temporary-storage capacity without logging request bodies.

## Browser works but pairing fails

Use only the origin in `--broker-url`—no path, query, fragment, or credentials.
Confirm the client reaches the same HTTPS origin and that its clock and
certificate trust are valid.

## Certificate failure

Check the hostname, DNS, certificate chain, validity period, and TLS termination.
Do not bypass validation for public use.

## SSH tunnel disconnected

Check the SSH process or operator-owned service, `ExitOnForwardFailure`, server
keepalives, key access, and the VPS loopback forward before checking its proxy.

## Tailscale URL unreachable

Run `tailscale status` and `tailscale serve status` yourself. Confirm the client
is in the permitted tailnet and the route targets broker loopback.

## Client uses an old URL

Update or re-pair that client with the current operator-owned origin. Changing a
connectivity layer does not rewrite existing client profiles.
