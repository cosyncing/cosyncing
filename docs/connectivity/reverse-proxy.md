# Caddy and nginx reverse proxies

> [!WARNING]
> Public or untrusted-network exposure requires broker contract revision 17 or
> later. Revision 16 and earlier do not enforce the principal, revocation, and
> artifact boundaries described here and must not be exposed publicly. Publish
> or update a revision-17-capable client before promoting the revision-17
> broker. Run `cosy version --json` on the broker host and confirm that
> `contract.revision` is at least `17` before creating any public route.

Use a same-host reverse proxy when a domain should reach cosyncing over HTTPS:

```text
client -> HTTPS/WSS -> Caddy or nginx -> HTTP/WS -> 127.0.0.1:7734
```

Keep the broker loopback-only. The proxy owns TLS, certificates, public
listeners, logs, and teardown. cosyncing still authenticates every sensitive API
and WebSocket request; forwarded headers are not authorization evidence.

Use an independent identity-aware gate, mTLS, VPN, or source allowlist when the
hostname is reachable from the unrestricted internet. The broker boundary is
designed to fail closed, but a separate ingress absorbs credential stuffing,
connection floods, and mistakes in either layer.

## Caddy

Copy [the example Caddyfile](../../examples/connectivity/Caddyfile), replace the
domain, then validate and load it using the service layout for your installation.
Caddy's `reverse_proxy` supports WebSocket upgrades without a separate route.

```bash
caddy validate --config examples/connectivity/Caddyfile
sudo systemctl reload caddy
cosy pair --broker-url https://cosy.example.com
```

Remove the site block and reload Caddy to tear it down. See Caddy's
[`reverse_proxy` reference](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy).

## nginx

Copy [the nginx example](../../examples/connectivity/nginx-cosyncing.conf),
replace the domain and certificate paths, and include it from your nginx
configuration. The example explicitly forwards the WebSocket `Upgrade` and
`Connection` headers.

```bash
sudo nginx -t
sudo systemctl reload nginx
cosy pair --broker-url https://cosy.example.com
```

Remove the included site, run `nginx -t`, and reload nginx to tear it down. See
nginx's [WebSocket proxying guide](https://nginx.org/en/docs/http/websocket.html).

For either proxy:

- keep pairing acceptance at 16 KiB and WebSocket ticket issuance at 64 KiB;
- keep ordinary JSON APIs at 1 MiB and set envelope/upload limits to the broker
  values the deployment selected;
- allow long-lived WebSockets, including idle periods and reconnection;
- terminate public TLS with a valid certificate and HSTS;
- rate-limit health, pairing acceptance, WebSocket ticket issuance, and upgrades;
- limit concurrent WebSockets per source or authenticated ingress identity;
- do not log authorization headers, request bodies, query strings, or complete
  pairing-accept paths;
- test health, pairing, session attach, reconnect, upload, and artifact download
  through the public origin before relying on it.

Verify the authentication boundary before pairing:

```bash
curl -si https://cosy.example.com/api/sessions
```

The response without credentials must be `401 Unauthorized`. A source broker
without a configured token is not safe merely because `/api/health` reports a
current contract revision.
