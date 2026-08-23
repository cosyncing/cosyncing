# Tailscale Serve

Tailscale is an optional private connectivity method, not a cosyncing
prerequisite. Tailscale Serve terminates tailnet HTTPS and forwards to the local
broker:

```text
tailnet client -> Tailscale Serve -> http://127.0.0.1:7734
```

Install and sign in to Tailscale independently, start the cosyncing broker, then
run the [operator-owned example](../../examples/connectivity/tailscale-serve.sh):

```bash
bash examples/connectivity/tailscale-serve.sh 7734
tailscale serve status
```

The example uses `tailscale serve --bg`. Tailscale stores a background Serve
configuration and resumes it after a device reboot or a `tailscale down` /
`tailscale up` cycle. This works only when `tailscaled` itself starts again.
cosyncing does not install, enable, or monitor that daemon.

On WSL, both `tailscaled` and Tailscale Serve must run inside the same WSL
distribution as the loopback broker. After restarting Windows or WSL, open that
distribution and verify both layers before relying on remote access:

```bash
cosy status
tailscale status
tailscale serve status
```

Use the HTTPS URL printed by `tailscale serve status`:

```bash
cosy pair --broker-url https://host.example.com
```

Do not bind cosyncing to a Tailscale IP and do not use Funnel unless you intend
public exposure. On WSL, Tailscale Serve must run in the same WSL environment as
the loopback broker; a Windows-host process cannot reach WSL loopback through
the same path.

cosyncing does not inspect, repair, or remove this route. Inspect and remove it
yourself:

```bash
tailscale serve status
tailscale serve --https=443 off
```

Recheck `tailscale serve status` after teardown. See the upstream
[Tailscale Serve command reference](https://tailscale.com/docs/reference/tailscale-cli/serve)
for the syntax supported by your installed version.
