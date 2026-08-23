# Connectivity boundary

cosyncing's broker always listens on IPv4 loopback:

```text
http://127.0.0.1:7734
```

The configured port may differ, but the listener address does not. A proxy,
tunnel, VPN, private overlay, or other ingress can make that service reachable
from another device. The operator owns that connectivity layer independently
of cosyncing.

## Ownership

cosyncing owns the broker process and service, its configuration and state,
broker and paired-device credentials, pairing, application protocols, and
agent-session control. Setup, status, doctor, repair, upgrade, and uninstall
operate only on those resources.

The operator owns every process and resource that forwards remote traffic to
the loopback listener. This includes VPN and overlay software, reverse proxies,
tunnels, DNS, TLS certificates, firewall rules, and router configuration.
cosyncing does not create, inspect, repair, or remove them.

This split keeps local-only use complete and safe by default without preventing
private or public deployment. Connectivity software forwards to the broker's
loopback URL; it does not change the broker listener.

## Pairing locators

A pairing offer may include a client-reachable Broker URL, such as
`https://cosy.example.com`. That URL is a one-time locator for the client. It is
not stored as broker configuration, reused for later offers, monitored, or
treated as a lifecycle-owned endpoint.

The URL may also be omitted from an offer. In that case the client must obtain
the reachable Broker URL separately before it can accept the offer. This keeps
authentication material and network location separable when the operator does
not want the QR code to disclose the address.

Legacy pairing payloads that name a provider-specific transport remain
parseable. Clients normalize them to the same URL-based behavior and do not
branch on the provider.

## Reverse-proxy requirements

Server-generated application links should be relative paths. The client
resolves them against the Broker URL in its own profile. Durable state must not
be derived from `Host`, `Forwarded`, `X-Forwarded-Host`, or
`X-Forwarded-Proto` headers.

Forwarded headers are never authorization evidence and must not influence
credential scope, broker identity, pairing identity, or trust level. Every
sensitive HTTP route and WebSocket path enforces cosyncing authentication even
when a proxy terminates TLS or applies its own access policy.

The broker treats every HTTP and WebSocket request as remote, even when the TCP
peer is loopback. Same-machine authority requires a future non-forwardable IPC
capability; neither a direct browser request nor a proxy connection supplies
one. Features that expose workspace files or transcript exports therefore need
explicit local configuration before any authenticated HTTP client can use them.

Public exposure requires HTTPS/WSS. The proxy must preserve WebSocket upgrades,
enforce suitable request-size and timeout limits, and avoid logging credentials
or sensitive request bodies.

## Lifecycle consequences

Removing cosyncing must not remove an operator-managed route. If an older
cosyncing release recorded ownership of an external route, migration
relinquishes that record without invoking the provider or changing the live
route. This preserves existing client connectivity while moving future control
to the operator.
