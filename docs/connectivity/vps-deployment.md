# VPS deployment

When cosyncing runs directly on a VPS, keep the broker private to the host and
publish only a reverse proxy:

```text
internet :443 -> Caddy/nginx -> 127.0.0.1:7734
```

Prerequisites are a maintained Linux VPS, a domain whose DNS points to it, and a
valid HTTPS certificate. Permit only SSH and the proxy's HTTP/HTTPS ports in the
host and provider firewalls. Do not open port `7734`.

1. Install and set up cosyncing, then select its supported persistent user
   service or arrange an operator-owned foreground supervisor.
2. Confirm `http://127.0.0.1:7734/api/health` locally.
3. Configure Caddy or nginx using [the reverse-proxy guide](reverse-proxy.md).
4. Confirm authenticated HTTP and WebSocket flows through the HTTPS origin.
5. Pair with `cosy pair --broker-url https://cosy.example.com`.

Keep broker, proxy, and OS updates current. Review proxy and cosyncing logs
without copying credentials into tickets. Back up only documented durable state,
not transient caches.

For teardown, revoke paired devices, remove the proxy site, remove its DNS and
firewall rules, verify the domain no longer routes, then uninstall cosyncing if
desired. Each action is operator-owned; cosyncing does not remove the others.
