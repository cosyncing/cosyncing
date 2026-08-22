# WireGuard and EasyTier

A private overlay makes hosts mutually reachable, but it does not make a service
bound to loopback reachable through the overlay interface. Keep cosyncing on
`127.0.0.1:7734` and run an independent forwarder that:

1. listens only on the intended WireGuard or EasyTier interface/address;
2. forwards HTTP and WebSocket traffic to `127.0.0.1:7734`;
3. preserves request bodies and long-lived connections;
4. is protected by overlay access control and the host firewall.

Do not change the cosyncing listener. A Caddy or nginx instance can provide the
forwarder; bind its listener to the exact overlay address, not `0.0.0.0`. The
client URL may be overlay HTTP when the overlay provides authenticated
encryption, though HTTPS is safer when traffic may cross another boundary:

```bash
cosy pair --broker-url http://overlay-host.example.test:8443
```

cosyncing will warn about non-loopback HTTP because it cannot verify the
overlay's protection.

Teardown is operator-owned: remove the forwarder listener, firewall allowance,
and overlay peer/address as appropriate, then verify the address no longer
answers. Consult the upstream [WireGuard quick start](https://www.wireguard.com/quickstart/)
or [EasyTier documentation](https://easytier.cn/en/) for overlay setup.
