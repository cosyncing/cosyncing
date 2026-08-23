# Connectivity

cosyncing runs its broker on `127.0.0.1:7734` and does not configure network
access. Choose and operate a separate proxy, tunnel, VPN, mesh network, or
forwarder when another device must connect.

> [!WARNING]
> Public or untrusted-network exposure requires broker contract revision 16 or
> later. Broker 0.4.1 and earlier do not enforce the authentication boundary
> described here and must not be exposed publicly. Run `cosy version --json`
> on the broker host and confirm that `contract.revision` is at least `16`
> before creating any public route.

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

For the shortest private setup, use Tailscale Serve if your devices already use
Tailscale. Use WireGuard or EasyTier when you want to operate the overlay
yourself; an overlay address still needs a forwarder to the loopback broker.

After `cosyncing setup`, you may follow these guides yourself or give this URL
to a coding agent and ask it to configure the method you chose:

```text
https://github.com/cosyncing/cosyncing/tree/main/docs/connectivity
```

For example: “Follow the cosyncing connectivity guide above and configure
Tailscale Serve for this broker. Keep cosyncing bound to 127.0.0.1, show me the
commands before changing the machine, and verify the route afterward.” Replace
Tailscale Serve with EasyTier or another method when appropriate. The resulting
route remains operator-owned even when an agent helps create it.

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
