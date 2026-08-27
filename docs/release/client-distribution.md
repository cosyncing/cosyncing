# Client distribution

Client releases are separate from the npm broker package and compiled native
broker releases. A `client-vX.Y.Z` tag stages four client artifacts from the
reviewed tag:

- a project-key-signed Android APK;
- a Linux x64 tarball;
- an unsigned Apple Silicon macOS DMG; and
- an unsigned Windows x64 portable ZIP.

iOS distribution is deferred. TestFlight and App Store distribution require an
active Apple Developer Program membership; simulator compilation remains part
of public CI.

## Release controls

`.github/workflows/client-release.yml` requires the tag version to equal both
the root package version and the base version in `apps/client/pubspec.yaml`. The
tagged commit must already be on `main`, and the complete repository check runs
before packaging.

The workflow creates or resets only the matching draft, builds each platform on
its native hosted runner, uploads the four final assets, generates
`SHA256SUMS`, downloads and verifies the remote set, and publishes a GitHub
prerelease for physical acceptance. It never builds or ships the native broker.

After physical acceptance, `.github/workflows/client-release-promote.yml`
requires the exact tag plus typed `PROMOTE` confirmation. It verifies the same
five remote assets and promotes them stable without rebuilding or replacing
anything.

## Client-first rollout order

Broker and client releases use separate publication channels, and no workflow
gates one on the other. A release is client-first whenever a client that is
already published cannot fully drive the new broker. Before publishing the npm
broker for such a release:

1. publish and physically accept the matching client release;
2. promote that client release stable;
3. confirm every supported client download carries the new behavior; and
4. only then publish the npm broker release.

Do not reverse these steps. Holding this order is a manual responsibility; the
release workflows do not enforce it.

The order is mandatory whenever a release raises the broker's minimum client
contract revision. Past that floor an older client does not merely miss new
features — the pairing negotiates read-only and session controls stay disabled,
so a user whose broker updates first cannot drive their sessions until they
install a new client. A minimum-revision bump is therefore always at least a
minor version, and its release notes say so. The web client is exempt in both
directions because it ships inside the broker package and always matches it;
the ordering protects native desktop and mobile installs.

Release 0.5.0 raised the minimum client contract revision to 17. A 0.4.1 or
older client is read-only against a 0.5.0 broker.

### Pairing payload version 3

Pairing payload version 3 was the first change published under this rule. A
v1/v2 client cannot parse a v3 pairing offer. The updated client remains able
to pair with v1/v2 brokers during the rollout.
While connected to a revision-15 broker, that client also retains the old
WebSocket query credential path. It selects the fallback only after an
authenticated health response identifies revision 15; current brokers always
use one-use tickets. The revision-16 broker raises its minimum client revision
to 16 and rejects long-lived query credentials.

## Protected configuration

The `client-release-candidate` environment holds:

- `COSYNCING_ANDROID_KEYSTORE_B64`
- `COSYNCING_ANDROID_KEYSTORE_PASSWORD`
- `COSYNCING_ANDROID_KEY_ALIAS`
- `COSYNCING_ANDROID_KEY_PASSWORD`

The keystore must be backed up outside GitHub. Losing it prevents Android from
accepting future updates over the installed app. The workflow materializes it
only in runner temporary storage and fails closed rather than falling back to
Flutter's debug certificate. The final APK signer must also match the reviewed,
non-secret certificate fingerprint in
`docs/release/android-signing-certificate.sha256`; replacing the environment
secret with a different release key therefore fails publication.

The `client-production` environment guards manual stable promotion and contains
no signing key.

## Unsigned desktop policy

The macOS and Windows filenames, release notes, and user instructions state
that those builds are unsigned. macOS Gatekeeper and Windows SmartScreen may
warn or block first launch. Checksums provide file integrity, not publisher
authentication. A later signing/notarization lane must publish a new version;
it must not silently replace existing assets.
