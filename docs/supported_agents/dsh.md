# DeepSeek Harness (experimental)

The provisional DeepSeek Harness adapter is intended for source contributors.
It was verified against `@deepseek-ai/dsh` 0.1.0-rc.6 and connects to a `dsh
web` host that you start and own. cosyncing does not install, start, stop, or
configure that host.

The adapter is default-off. Enable it only in a foreground source-broker
process:

```bash
COSYNCING_ENABLE_DSH=1 \
COSYNCING_DSH_BASE_URL=http://127.0.0.1:3080 \
bun run broker
```

Do not start a full source broker alongside an installed broker that owns the
same native agents. Stop the installed service for the review window and
restore it afterward.

## Current behavior

- Existing sessions and history are discovered from the host.
- Multiple active foreground cosyncing clients share the ordered transcript
  and live control surface.
- Session creation and rename, text prompts, permission and question replies,
  interruption, reconnect, and removal are supported.
- A background resident tab does not keep a DSH subscription. Foregrounding it
  reattaches and catches up from history.
- The adapter fails closed when host identity cannot be verified or a session
  has been removed.

Model selection, file and image input, background resident subscriptions, and
some DSH-specific message presentation remain provisional. The upstream host
exposes one writable client contract rather than a separate read-only Observe
credential, so cosyncing accepts only an explicit foreground `live` attach.
