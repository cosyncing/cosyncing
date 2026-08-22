# Connectivity

cosyncing runs its broker on `127.0.0.1:7734` and does not configure network
access. Choose and operate a separate proxy, tunnel, VPN, mesh network, or
forwarder when another device must connect.

Every supported topology keeps this boundary:

```text
client -> operator-owned connectivity -> http://127.0.0.1:7734
```

| Method | Best for | Public internet | TLS | Extra process |
| --- | --- | ---: | --- | --- |
| [Tailscale Serve](tailscale-serve.md) | Private remote access | No | Provided | Tailscale |
| [Caddy or nginx](reverse-proxy.md) | Domain-based HTTPS | Yes | Required | Proxy |
| [VPS deployment](vps-deployment.md) | Broker hosted on a VPS | Yes | Required | Proxy |
| [SSH reverse tunnel](ssh-reverse-tunnel.md) | Workstation behind NAT | Via VPS | At VPS | SSH + proxy |
| [WireGuard or EasyTier](wireguard-easytier.md) | Self-managed private overlay | No | Overlay-dependent | Overlay + forwarder |
| [Cloudflare Tunnel or FRP](cloudflare-tunnel-frp.md) | Outbound or self-hosted tunnel | Yes | Required | Tunnel client |
| [LAN proxy](lan-access.md) | One trusted local network | No | Recommended | Proxy |

Read the [security checklist](security.md) before exposing a broker and use
[troubleshooting](troubleshooting.md) when the local broker works but a forwarded
URL does not. Users upgrading from older managed Tailscale releases should read
[the migration guide](migrating-from-managed-tailscale.md).

After the connectivity layer is ready, include its client-reachable origin in a
new pairing offer:

```bash
cosy pair --broker-url https://cosy.example.com
```

Omit `--broker-url` to create an authentication-only offer. The client must then
already know, or be given, its broker URL. cosyncing does not persist, probe,
monitor, repair, or remove the path behind a supplied URL.
