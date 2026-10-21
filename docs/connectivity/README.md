# Connectivity

cosyncing runs its broker on `127.0.0.1:7734` and does not configure network
access. Choose and operate a separate proxy, tunnel, VPN, mesh network, or
forwarder when another device must connect.

> [!WARNING]
> Public or untrusted-network exposure requires broker contract revision 17 or
> later. Revision 16 and earlier do not enforce the principal, revocation, and
> artifact boundaries described here and must not be exposed publicly. Publish
> or update a revision-17-capable client before promoting the revision-17
> broker. Run `cosy version --json` on the broker host and confirm that
> `contract.revision` is at least `17` before creating any public route.

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
already know, or be given, its broker URL. cosyncing does not configure, repair,
or remove the operator-owned path behind a supplied URL.

## Several addresses for one server

Open **Settings → Servers → Saved servers**, then select a server's name to
manage its addresses. Labels such as LAN, Tailscale, and Tunnel are local to this
device. **Test** verifies server identity, sign-in, protocol compatibility, and
WebSocket readiness before an additional address can carry credentials.

**Automatic** chooses among enabled, approved addresses. **Fixed** keeps one
address, including when it fails. Changing an address preserves the logical
server's sessions, drafts, and file ownership. Removing an address does not
remove the server. Separately saved entries with the same verified server and
access binding can be merged after review; different paired devices' access
bindings are kept separate.

Native clients offer reusable HTTP and SOCKS5 proxy profiles under an address's
**Advanced** options. SOCKS5 resolves the destination through the proxy. A bound
address cannot retry Direct when its proxy fails or its credentials are missing.
Automatic can still choose another explicitly enabled address with its own path.
Proxy profiles and secrets remain on this device. Browsers use their own network
configuration; an imported native proxy requirement is blocked until explicitly
changed or another approved address is selected.

The broker owner can open **Advertised addresses and browser origins** from the
address manager to configure advertised broker addresses and trusted browser-client
origins separately. Advertising a destination does not grant a web origin access.
Browser CORS and mixed-content restrictions still apply. An older broker can
retain its original single-address connection; adding addresses requires the
`server-routes-v1` capability.
