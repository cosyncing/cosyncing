# Caddy and nginx reverse proxies

Use a same-host reverse proxy when a domain should reach cosyncing over HTTPS:

```text
client -> HTTPS/WSS -> Caddy or nginx -> HTTP/WS -> 127.0.0.1:7734
```

Keep the broker loopback-only. The proxy owns TLS, certificates, public
listeners, logs, and teardown. cosyncing still authenticates every sensitive API
and WebSocket request; forwarded headers are not authorization evidence.

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

- allow request bodies large enough for the intended file-upload limit;
- allow long-lived WebSockets, including idle periods and reconnection;
- terminate public TLS with a valid certificate;
- do not log authorization headers or request bodies;
- test health, pairing, session attach, reconnect, upload, and artifact download
  through the public origin before relying on it.
