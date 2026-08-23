# Operator-owned connectivity examples

These files are optional starting points. cosyncing never imports or invokes
them. They do not install software, configure DNS or firewalls, or contain
credentials. Review and adapt them to your host before use.

| Example | Guide |
| --- | --- |
| `tailscale-serve.sh` | [Tailscale Serve](../../docs/connectivity/tailscale-serve.md) |
| `Caddyfile` / `nginx-cosyncing.conf` | [Reverse proxies](../../docs/connectivity/reverse-proxy.md) |
| `ssh-reverse-tunnel.sh` / `systemd/…service` | [SSH reverse tunnel](../../docs/connectivity/ssh-reverse-tunnel.md) |

Every created route, proxy, tunnel, service, certificate, and DNS record is
operator-owned. Each guide gives teardown steps.
