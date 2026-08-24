# Connectivity troubleshooting

Start at the boundary and move outward. Do not change the broker listener.

For public or untrusted-network routes, first run `cosy version --json` on the
broker host and require `contract.revision >= 17`. Update revision-17-capable
clients before promoting the revision-17 broker.

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

## Multi-machine roster authentication

Broker contract revision 16 first protected `/api/sessions`; revision 17 is the
minimum for public exposure because it also scopes peers, revocation, and
artifacts. A URL-only
`COSYNCING_MACHINE_PEERS` entry can still read a revision-15 peer during the
client-first rollout, but reports an explicit machine-peer authentication
configuration error after that peer upgrades. Run `cosy doctor` before the
broker upgrade to find tokenless entries.

Use JSON configuration with an explicit credential. A revocable paired-device
credential is preferred when one is available:

```json
[
  {
    "id": "workstation-b",
    "url": "https://broker-b.example.com",
    "credential": {
      "kind": "peer-token",
      "value": "PAIRED_PEER_TOKEN"
    }
  }
]
```

For compatibility, `"token": "BROKER_OWNER_TOKEN"` remains a deprecated
shorthand for `{"kind":"broker-token","value":"..."}`. Do not put either
credential in the peer URL. Restart the local broker after updating
`COSYNCING_MACHINE_PEERS`; aggregation recovers on its next roster fetch.
