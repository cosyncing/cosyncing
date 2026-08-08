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

No runtime database, cache, transcript, credential, trace, screenshot, or
generated output belongs in Git. The public-tree CI policy rejects these paths
and file types.

Future migrations must be forward-only, tested from the previously supported
release, and documented before a tag is created. Broker binary upgrades use the
signed manifest, isolated installer, health check, and rollback process in the
[release documentation](../release/broker-release-signing.md).
