# SSH reverse tunnel through a VPS

> [!WARNING]
> Public or untrusted-network exposure requires broker contract revision 17 or
> later. Revision 16 and earlier do not enforce the principal, revocation, and
> artifact boundaries described here and must not be exposed publicly. Publish
> or update a revision-17-capable client before promoting the revision-17
> broker. Run `cosy version --json` on the broker host and confirm that
> `contract.revision` is at least `17` before creating any public route.

This topology keeps a workstation behind NAT while a VPS owns public HTTPS:

```text
workstation 127.0.0.1:7734
  -> SSH reverse tunnel
VPS 127.0.0.1:17734
  -> Caddy/nginx
public HTTPS origin
```

The reverse forward must bind to VPS loopback. Run the
[example script](../../examples/connectivity/ssh-reverse-tunnel.sh) from the
workstation after configuring SSH keys and host verification:

```bash
bash examples/connectivity/ssh-reverse-tunnel.sh user@vps.example.com 17734 7734
```

It uses `ExitOnForwardFailure`, server keepalives, and:

```text
-R 127.0.0.1:17734:127.0.0.1:7734
```

On the VPS, point Caddy or nginx at `127.0.0.1:17734`, require public HTTPS, and
follow the [reverse-proxy security rules](reverse-proxy.md). Use an
operator-owned systemd unit or autossh if the tunnel must survive disconnections;
the [example unit](../../examples/connectivity/systemd/cosyncing-ssh-reverse-tunnel.service)
is a template, not an installed cosyncing resource.

Pair only after testing the public path:

```bash
cosy pair --broker-url https://cosy.example.com
```

The VPS and its SSH account can reach the broker through the tunnel. Restrict
the key, account, firewall, and proxy accordingly. To tear down, stop and disable
your tunnel unit or SSH process, remove the VPS proxy site, then verify nothing
listens on VPS loopback port `17734`.

See the upstream [`ssh_config`](https://man.openbsd.org/ssh_config) reference for
the options supported by your SSH client.
