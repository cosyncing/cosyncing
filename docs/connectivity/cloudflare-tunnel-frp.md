# Cloudflare Tunnel and FRP

> [!WARNING]
> Public or untrusted-network exposure requires broker contract revision 16 or
> later. Broker 0.4.1 and earlier do not enforce the authentication boundary
> described here and must not be exposed publicly. Run `cosy version --json`
> on the broker host and confirm that `contract.revision` is at least `16`
> before creating any public route.

Both methods can make the broker internet-reachable. Keep cosyncing on loopback,
require application authentication, and use a public HTTPS origin.

## Cloudflare Tunnel

Configure a named, operator-owned tunnel whose origin service is:

```text
http://127.0.0.1:7734
```

Quick Tunnels are suitable only for temporary testing; production should use a
named tunnel with controlled DNS and credentials. Test WebSocket attach,
reconnection, upload limits, and artifact download before use. Pair with the
configured HTTPS hostname. See the official [Cloudflare Tunnel documentation](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/).

Teardown: stop and disable `cloudflared`, delete the tunnel route and DNS record,
remove its local credential, and rotate it if exposed.

## FRP

Run `frpc` on the broker host and `frps` on an operator-controlled VPS. Configure
the client backend as `127.0.0.1:7734`; terminate public HTTPS at a proxy on the
VPS rather than exposing plain broker HTTP. FRP authentication, TLS, server
ports, firewall, and credentials remain operator-owned.

The current FRP configuration reference documents `localIP`, `localPort`, TLS,
and authentication options: [FRP proxy configuration](https://gofrp.org/en/docs/reference/proxy/).

Teardown: stop both FRP components, remove their configuration and public proxy,
close the VPS ports, remove DNS, and rotate FRP credentials. Neither method is
inspected or removed by `cosy uninstall`.
