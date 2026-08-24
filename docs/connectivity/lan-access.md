# LAN access

If any device or segment on the LAN is untrusted, apply the public-exposure
requirements in [Connectivity security](security.md): use contract revision 17
or later, update revision-17-capable clients before the broker, and place an
independent access-control layer in front of the broker.

For a trusted LAN, run an independent reverse proxy bound to one intended LAN
address and forward it to `127.0.0.1:7734`. Never expose the broker directly or
bind it to `0.0.0.0`.

```text
LAN client -> proxy at 192.0.2.10:8443 -> 127.0.0.1:7734
```

- Bind the proxy to the exact interface address.
- Permit only the intended source subnet in the host firewall.
- Prefer HTTPS. Plain HTTP exposes credentials and session traffic to anyone
  able to observe the LAN.
- Treat guest Wi-Fi, shared offices, and unmanaged networks as untrusted.
- Keep cosyncing authentication enabled and proxy logs free of credentials.
- Validate WebSocket upgrades and file-upload limits.

Pair using the proxy origin, including its port when nonstandard. cosyncing warns
for non-loopback HTTP because it cannot assess the LAN:

```bash
cosy pair --broker-url https://192.0.2.10:8443
```

To tear down, stop the proxy, remove its site and firewall rule, and verify the
LAN address no longer answers. These resources remain operator-owned.
