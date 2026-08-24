# Migrating from managed Tailscale Serve

Older cosyncing versions could create a Tailscale Serve route and record it as a
cosyncing-owned resource. Current versions leave that route unchanged, remove
the old ownership intent and receipt, and report that the route is now managed
by the operator.

This continuity rule means existing clients should keep working during upgrade:

- setup, repair, and uninstall do not invoke Tailscale;
- the existing route is neither inspected nor changed;
- uninstall does not remove the route;
- future route changes are your responsibility.

Promote or update clients to a revision-17-capable release before upgrading the
broker to contract revision 17. This client-first order is required because the
revision-17 broker adds principal-scoped authorization and authenticated
artifact delivery. During the earlier revision-16 transition, a stale
revision-15 client could still load the authenticated session roster but would
reconnect repeatedly because it sent a retired query credential instead of
requesting a WebSocket authorization ticket.

Inspect the retained route manually:

```bash
tailscale serve status
```

If you want to keep it, compare its target with `http://127.0.0.1:7734` and
follow [the independent Tailscale guide](tailscale-serve.md) for future setup.
Create new offers with the URL reported by Tailscale:

```bash
cosy pair --broker-url https://host.example.com
```

To retire the old route, first confirm another access path exists for every
device that needs it, then run:

```bash
tailscale serve --https=443 off
tailscale serve status
```

Removing cosyncing and removing Tailscale connectivity are separate operations.
