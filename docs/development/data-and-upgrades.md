# Local data and predecessor upgrades

The consolidated application uses a new `cosyncing_client` application
identity. Existing installations of the predecessor client start fresh. There
is no legacy database, preference, or secure-storage key migration. Old data is
left orphaned on the local device so this release cannot silently reinterpret
or delete it.

The client stores its database and preferences in the platform application-data
location and credentials in platform secure storage. Artifact previews and
downloads use platform cache or user-selected destinations. The broker stores
runtime state under the current user's `.cosyncing` directory unless an
operator selects another supported location.

One kind of broker state lives outside that directory: a file you attach to a
prompt is staged in `<workspace>/.cosyncing/inbox`, because the agent has to be
able to read it from its own working directory. That is inside a git working
tree, so the broker collects it — hourly, oldest first, on the retention and
size limits in the [changelog](../CHANGELOG.md). It only sweeps inboxes it
staged into, only when both `.cosyncing` and `inbox` resolve to themselves, and
never a file a staged upload still points at.

No runtime database, cache, transcript, credential, trace, screenshot, or
generated output belongs in Git. The public-tree CI policy rejects these paths
and file types.

Future migrations must be forward-only, tested from the previously supported
release, and documented before a tag is created. Broker binary upgrades use the
signed manifest, isolated installer, health check, and rollback process in the
[release documentation](../release/broker-release-signing.md).
